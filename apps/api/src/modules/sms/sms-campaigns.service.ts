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
import { normalisePhone } from '../push-notifications/message-channel';
import { AddressAudienceScope } from '../push-notifications/services/address-audience';
import {
  JOB_DISPATCH_CAMPAIGN,
  PushCampaignJobData,
  QUEUE_PUSH_CAMPAIGN,
} from '../../queue/queue.constants';
import { SmsAudienceService } from './sms-audience.service';
import { SmsSettingsService } from './sms-settings.service';
import { SmsProviderRegistry } from './sms-provider.registry';
import { renderSms } from './sms-rendering';
import { campaignLabel } from './sms-label';
import {
  SendSmsCampaignDto,
  SmsAudiencePreviewDto,
  TestSendSmsDto,
} from './dto/sms.dto';

export { campaignLabel } from './sms-label';

/**
 * Creates SMS campaigns.
 *
 * The email campaign service's twin: an SMS campaign is a row in the shared
 * campaign table, queued under the shared job, so scheduling, recurrence,
 * timezone waves and experiment arms come for free. The text lives in
 * `body`; `title` is only the label lists show.
 */
@Injectable()
export class SmsCampaignsService {
  private readonly logger = new Logger(SmsCampaignsService.name);

  constructor(
    @InjectRepository(PushNotificationLogEntity)
    private readonly logRepository: Repository<PushNotificationLogEntity>,
    @InjectRepository(PushConfigEntity)
    private readonly policyRepository: Repository<PushConfigEntity>,
    @InjectQueue(QUEUE_PUSH_CAMPAIGN)
    private readonly queue: Queue<PushCampaignJobData>,
    private readonly settings: SmsSettingsService,
    private readonly audience: SmsAudienceService,
    private readonly push: PushNotificationsService,
    private readonly registry: SmsProviderRegistry,
    private readonly activity: ProjectActivityService,
  ) {}

  private async resolveAudience(
    input: { projectId: string; segmentId?: string; deviceIdentityIds?: string[] },
    requireOptIn: boolean,
  ): Promise<{
    targetType: 'project' | 'devices' | 'segment';
    scope: AddressAudienceScope;
    recipients: number;
  }> {
    const policy = await this.policyRepository.findOne({
      where: { projectId: input.projectId },
    });
    const cap = policy?.frequencyCapPerDay ?? null;

    let targetType: 'project' | 'devices' | 'segment' = 'project';
    let deviceIdentityIds: string[] | null = null;

    if (input.segmentId) {
      targetType = 'segment';
      deviceIdentityIds = await this.push.segmentDeviceIdentityIds(
        input.projectId,
        input.segmentId,
      );
    } else if (input.deviceIdentityIds && input.deviceIdentityIds.length > 0) {
      targetType = 'devices';
      deviceIdentityIds = input.deviceIdentityIds;
    }

    const scope: AddressAudienceScope = {
      projectId: input.projectId,
      deviceIdentityIds,
      requireOptIn,
    };
    return { targetType, scope, recipients: await this.audience.count(scope, cap) };
  }

  async previewAudience(dto: SmsAudiencePreviewDto): Promise<{
    targetType: 'project' | 'devices' | 'segment';
    recipients: number;
    requireOptIn: boolean;
  }> {
    const settings = await this.settings.find(dto.projectId);
    const requireOptIn = settings?.requireOptIn ?? true;
    const { targetType, recipients } = await this.resolveAudience(dto, requireOptIn);
    return { targetType, recipients, requireOptIn };
  }

  /** How many people a journey's SMS step to these identities would reach. */
  async countReachable(projectId: string, deviceIdentityIds: string[]): Promise<number> {
    if (deviceIdentityIds.length === 0) return 0;
    const settings = await this.settings.find(projectId);
    if (!settings?.provider) return 0;
    const { recipients } = await this.resolveAudience(
      { projectId, deviceIdentityIds },
      settings.requireOptIn,
    );
    return recipients;
  }

  /**
   * A dashboard request (`requester`) writes `campaign.sent` or `campaign.scheduled` in
   * the row's transaction; a journey step passes `null` and writes nothing.
   */
  async send(dto: SendSmsCampaignDto, requester: ActivityRequester | null): Promise<PushNotificationLogEntity> {
    const { settings } = await this.settings.requireSendable(dto.projectId);

    const { targetType, scope, recipients } = await this.resolveAudience(
      dto,
      settings.requireOptIn,
    );

    if (recipients === 0) {
      throw new BadRequestException(
        settings.requireOptIn
          ? 'Nobody in this audience can be texted. SMS needs a phone number with a country code ' +
              '(+...) and, because this project requires opt-in, sms_opt_in set to true.'
          : 'Nobody in this audience has a phone number with a country code that has not opted out.',
      );
    }

    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    const sendTimeOptimised = dto.sendTimeOptimised === true;
    const deliverInRecipientTimezone =
      dto.deliverInRecipientTimezone === true || sendTimeOptimised;

    const variants: PushVariant[] | null =
      dto.variants && dto.variants.length > 0
        ? dto.variants.map((variant) => ({
            key: variant.key,
            title: variant.title,
            body: variant.body,
            weight: variant.weight,
          }))
        : null;

    if (variants) {
      const problem = validateVariants(variants, dto.controlPercentage ?? 0);
      if (problem) throw new BadRequestException(problem);
    }

    const isRecurring = !!dto.recurrence;
    if (isRecurring) {
      const problem = validateRecurrence(dto.recurrence!);
      if (problem) throw new BadRequestException(problem);
    }

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
        channel: 'sms',
        emailContent: null,
        title: dto.name?.trim() || campaignLabel(dto.body),
        body: dto.body,
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
        localSendTime: deliverInRecipientTimezone ? (dto.localSendTime ?? '09:00') : null,
        status: isScheduled ? 'scheduled' : 'queued',
      } as Partial<PushNotificationLogEntity>) as PushNotificationLogEntity,
      requester && {
        requester,
        entry: (saved) => campaignEntry(saved, heldOrSent(saved)),
      },
    );

    if (isScheduled) {
      this.logger.log(
        `SMS campaign ${log.id} held for ${log.scheduledAt?.toISOString()} (${recipients} recipient(s))`,
      );
      return log;
    }

    await this.queue.add(
      JOB_DISPATCH_CAMPAIGN,
      { logId: log.id, projectId: dto.projectId },
      { jobId: log.id },
    );
    this.logger.log(`Queued SMS campaign ${log.id} for ${recipients} recipient(s)`);
    return log;
  }

  /**
   * Texts one number and reports what happened. Bypasses consent and
   * suppression — it is the marketer's own phone — but uses the same
   * renderer and provider as a campaign.
   */
  async testSend(dto: TestSendSmsDto): Promise<{ delivered: boolean; error?: string }> {
    const to = normalisePhone(dto.to);
    if (!to) {
      throw new BadRequestException(
        'Enter the number in international form, with its country code: +14155550123.',
      );
    }
    const { settings, credentials } = await this.settings.requireSendable(dto.projectId);

    const message = renderSms({
      body: dto.body,
      identity: null,
      from: settings.sender,
      optOutText: settings.optOutText,
      statusCallback: this.settings.statusCallbackUrl(settings, null, null),
    });

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
      return {
        delivered: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

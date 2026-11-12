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
import { EmailContent } from '../push-notifications/message-channel';
import {
  JOB_DISPATCH_CAMPAIGN,
  PushCampaignJobData,
  QUEUE_PUSH_CAMPAIGN,
} from '../../queue/queue.constants';
import { EmailAudienceScope, EmailAudienceService } from './email-audience.service';
import { EmailSettingsService } from './email-settings.service';
import { EmailProviderRegistry } from './email-provider.registry';
import { renderEmail } from './email-rendering';
import { EmailUnsubscribeService } from './email-unsubscribe.service';
import {
  EmailAudiencePreviewDto,
  SendEmailCampaignDto,
  TestSendEmailDto,
} from './dto/email.dto';

/**
 * Creates email campaigns.
 *
 * An email campaign is a row in the same table as a push campaign, queued on
 * the same queue under the same job name. Scheduling, recurrence, timezone
 * waves and experiment arms are all handled downstream by code that only
 * looks at the row, which is why this service is short: its job is to check
 * the request and decide who the audience is, nothing more.
 */
@Injectable()
export class EmailCampaignsService {
  private readonly logger = new Logger(EmailCampaignsService.name);

  constructor(
    @InjectRepository(PushNotificationLogEntity)
    private readonly logRepository: Repository<PushNotificationLogEntity>,
    @InjectRepository(PushConfigEntity)
    private readonly policyRepository: Repository<PushConfigEntity>,
    @InjectQueue(QUEUE_PUSH_CAMPAIGN)
    private readonly queue: Queue<PushCampaignJobData>,
    private readonly settings: EmailSettingsService,
    private readonly audience: EmailAudienceService,
    private readonly push: PushNotificationsService,
    private readonly registry: EmailProviderRegistry,
    private readonly unsubscribe: EmailUnsubscribeService,
    private readonly activity: ProjectActivityService,
  ) {}

  /**
   * Who a campaign would reach. Shared by `send` and `previewAudience`, so the
   * number shown before sending comes from the code that decides the send.
   */
  private async resolveAudience(input: {
    projectId: string;
    segmentId?: string;
    deviceIdentityIds?: string[];
  }, requireOptIn: boolean): Promise<{
    targetType: 'project' | 'devices' | 'segment';
    scope: EmailAudienceScope;
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

    const scope: EmailAudienceScope = {
      projectId: input.projectId,
      deviceIdentityIds,
      requireOptIn,
    };
    return { targetType, scope, recipients: await this.audience.count(scope, cap) };
  }

  async previewAudience(dto: EmailAudiencePreviewDto): Promise<{
    targetType: 'project' | 'devices' | 'segment';
    recipients: number;
    requireOptIn: boolean;
  }> {
    const settings = await this.settings.find(dto.projectId);
    const requireOptIn = settings?.requireOptIn ?? true;
    const { targetType, recipients } = await this.resolveAudience(dto, requireOptIn);
    return { targetType, recipients, requireOptIn };
  }

  /** How many people a journey's email step to these identities would reach. */
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
  async send(dto: SendEmailCampaignDto, requester: ActivityRequester | null): Promise<PushNotificationLogEntity> {
    const { settings } = await this.settings.requireSendable(dto.projectId);

    const { targetType, scope, recipients } = await this.resolveAudience(
      dto,
      settings.requireOptIn,
    );

    if (recipients === 0) {
      throw new BadRequestException(
        settings.requireOptIn
          ? 'Nobody in this audience can be emailed. Email needs an address and, ' +
              'because this project requires opt-in, email_opt_in set to true.'
          : 'Nobody in this audience has an email address that is not unsubscribed or bounced.',
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
            body: variant.body ?? null,
            html: variant.html ?? null,
            preheader: variant.preheader ?? null,
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

    const content: EmailContent = {
      subject: dto.subject,
      html: dto.html,
      text: dto.text ?? null,
      preheader: dto.preheader ?? null,
    };

    const log = await saveCampaign(
      this.logRepository,
      this.activity,
      this.logRepository.create({
        projectId: dto.projectId,
        channel: 'email',
        emailContent: content,
        title: dto.subject,
        body: dto.text ?? undefined,
        data: undefined,
        targetType,
        targetDeviceIds: scope.deviceIdentityIds,
        segmentId: dto.segmentId ?? null,
        totalTokens: recipients,
        processedTokens: 0,
        successCount: 0,
        failureCount: 0,
        // Same rules as push: a split campaign is held until the sweep splits
        // it, and a recurring one is a template that fires on its schedule.
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
        `Email campaign ${log.id} held for ${log.scheduledAt?.toISOString()} (${recipients} recipient(s))`,
      );
      return log;
    }

    await this.queue.add(
      JOB_DISPATCH_CAMPAIGN,
      { logId: log.id, projectId: dto.projectId },
      { jobId: log.id },
    );
    this.logger.log(`Queued email campaign ${log.id} for ${recipients} recipient(s)`);
    return log;
  }

  /**
   * Sends one rendered email to one address and reports what happened.
   *
   * Bypasses consent and suppression on purpose — it is the marketer testing
   * their own inbox — but goes through the same renderer and provider, so a
   * test that arrives is evidence the campaign will.
   */
  async testSend(dto: TestSendEmailDto): Promise<{ delivered: boolean; error?: string }> {
    const { settings, credentials } = await this.settings.requireSendable(dto.projectId);

    const message = renderEmail({
      content: {
        subject: dto.subject,
        html: dto.html,
        text: dto.text ?? null,
        preheader: dto.preheader ?? null,
      },
      identity: null,
      sender: settings,
      unsubscribeUrl: this.unsubscribe.url(dto.projectId, dto.to.trim().toLowerCase()),
      tags: {},
    });

    try {
      const result = await this.registry
        .get(settings.provider)
        .sendToRecipients(credentials, [{ token: dto.to, message }]);
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

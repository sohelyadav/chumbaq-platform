import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { PushConfigEntity } from '../push-notifications/entities/push-config.entity';
import { PushCampaignStateService } from '../push-notifications/push-campaign-state.service';
import { ChannelRecipient } from '../push-notifications/services/channel-provider';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import {
  MAX_THROTTLE_WAIT_MS,
  PushCampaignJobData,
} from '../../queue/queue.constants';
import { EmailAudienceService } from './email-audience.service';
import { EmailSettingsService } from './email-settings.service';
import { EmailProviderRegistry } from './email-provider.registry';
import {
  CAMPAIGN_STOPPED_BY_SUSPENSION,
  ProjectSuspensionService,
} from '../projects/project-suspension.service';
import { EmailUnsubscribeService } from './email-unsubscribe.service';
import {
  CAMPAIGN_TAG,
  EmailMessage,
  IDENTITY_TAG,
  renderEmail,
} from './email-rendering';

/**
 * Recipients per page. Smaller than push's 500: each email is its own HTTP
 * call, so a page is the unit of work lost and redone after a crash, and at
 * SES's starting rate 500 would be most of a minute.
 */
export const EMAIL_BATCH_SIZE = 100;

/**
 * Delivers one email campaign. Called by the campaign processor for rows with
 * `channel = 'email'`.
 *
 * The walk is the push walk with a different reader: keyset pages, a
 * checkpoint after every page that only advances over the provider's
 * resolved prefix, and a thrown error — retried by BullMQ from that
 * checkpoint — when the provider stops short.
 */
@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);

  constructor(
    @InjectRepository(PushConfigEntity)
    private readonly policyRepository: Repository<PushConfigEntity>,
    private readonly state: PushCampaignStateService,
    private readonly settings: EmailSettingsService,
    private readonly audience: EmailAudienceService,
    private readonly registry: EmailProviderRegistry,
    private readonly unsubscribe: EmailUnsubscribeService,
    private readonly suspension: ProjectSuspensionService,
  ) {}

  async deliver(
    job: Job<PushCampaignJobData>,
    log: PushNotificationLogEntity,
  ): Promise<void> {
    if (!log.emailContent) {
      await this.state.markFailed(log.id, 'This email campaign has no content.');
      throw new UnrecoverableError(`Email campaign ${log.id} has no content`);
    }

    let sendable: Awaited<ReturnType<EmailSettingsService['requireSendable']>>;
    try {
      sendable = await this.settings.requireSendable(log.projectId);
    } catch (error) {
      // No retry will connect a provider, so this ends the campaign with the
      // reason the dashboard can act on.
      const detail = error instanceof Error ? error.message : 'Email is not configured';
      await this.state.markFailed(log.id, detail);
      throw new UnrecoverableError(detail);
    }
    const { settings, credentials } = sendable;
    const provider = this.registry.get(settings.provider);

    // Sending policy is shared with push and optional for email: a project
    // that only ever emails has no push config row, and no cap.
    const policy = await this.policyRepository.findOne({
      where: { projectId: log.projectId },
    });
    const cap = policy?.frequencyCapPerDay ?? null;
    const maxPerMinute = policy?.maxSendsPerMinute ?? null;

    const scope = {
      projectId: log.projectId,
      // Only `project` fans out; any other target type is narrowed to its
      // stored list, and a missing list reaches nobody. Same rule, and same
      // reason, as the push token reader.
      deviceIdentityIds: log.targetType === 'project' ? null : (log.targetDeviceIds ?? []),
      requireOptIn: settings.requireOptIn,
    };

    await this.state.markSending(log.id);

    let cursor: string | null = log.lastTokenId;
    let processed = log.processedTokens;

    for (;;) {
      const page = await this.audience.page(scope, cursor, EMAIL_BATCH_SIZE, cap, log.id);
      if (page.length === 0) break;

      // Per page, not per job: a large campaign runs for hours and suspension
      // is often urgent. Checked after the empty-page break so a campaign that
      // has already reached everyone still finishes as what it is. Returning
      // rather than throwing completes the job, so BullMQ spends no retries and
      // `markFailed` keeps what was delivered honest (`partial` or `failed`).
      if (await this.suspension.isSuspended(log.projectId)) {
        await this.state.markFailed(log.id, CAMPAIGN_STOPPED_BY_SUSPENSION);
        this.logger.warn(`Email campaign ${log.id} stopped: its tenant is suspended`);
        return;
      }

      const recipients = this.buildRecipients(log, page, settings);
      const result = await provider.sendToRecipients(credentials, recipients);

      if (result.resolvedCount > 0) {
        const resolved = page.slice(0, result.resolvedCount);
        const failed = new Set(result.failures.map((failure) => failure.token));

        // Always written for email, unlike push where only a cap needs them:
        // they are what makes the cap cross-channel, and what a person's
        // message history reads.
        await this.state.recordSentRecipients(
          log,
          resolved
            .filter((identity) => !failed.has(identity.email!))
            .map((identity) => identity.id),
        );

        cursor = resolved[resolved.length - 1].id;
        processed += result.resolvedCount;

        await this.state.recordBatch(log.id, {
          successCount: result.successCount,
          failureCount: result.failureCount,
          failures: result.failures.map(({ token, error, errorCode }) => ({
            token,
            error,
            errorCode,
          })),
          lastTokenId: cursor,
          processedInBatch: result.resolvedCount,
        });

        await job.updateProgress(
          log.totalTokens > 0
            ? Math.min(100, Math.round((processed / log.totalTokens) * 100))
            : 100,
        );
      }

      await this.throttle(result.resolvedCount, maxPerMinute);

      if (result.retryReason) {
        throw new Error(
          `${settings.provider} stopped after ${result.resolvedCount}/${page.length} ` +
            `recipients of email campaign ${log.id}: ${result.retryReason}`,
        );
      }
    }

    const status = await this.state.finalize(log.id);
    this.logger.log(`Email campaign ${log.id} finished with status ${status}`);
  }

  private buildRecipients(
    log: PushNotificationLogEntity,
    page: DeviceIdentityEntity[],
    sender: Parameters<typeof renderEmail>[0]['sender'],
  ): ChannelRecipient<EmailMessage>[] {
    return page.map((identity) => ({
      token: identity.email!,
      message: renderEmail({
        content: log.emailContent!,
        identity,
        sender,
        unsubscribeUrl: this.unsubscribe.url(log.projectId, identity.email!),
        tags: { [CAMPAIGN_TAG]: log.id, [IDENTITY_TAG]: identity.id },
      }),
    }));
  }

  private async throttle(sent: number, maxPerMinute: number | null): Promise<void> {
    if (!maxPerMinute || maxPerMinute <= 0 || sent <= 0) return;
    const waitMs = Math.min((sent / maxPerMinute) * 60_000, MAX_THROTTLE_WAIT_MS);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

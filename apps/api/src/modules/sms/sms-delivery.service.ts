import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { PushConfigEntity } from '../push-notifications/entities/push-config.entity';
import { PushCampaignStateService } from '../push-notifications/push-campaign-state.service';
import { SuppressionsService } from '../push-notifications/suppressions.service';
import { SuppressionReason } from '../push-notifications/entities/channel-suppression.entity';
import { ChannelFailure, ChannelRecipient } from '../push-notifications/services/channel-provider';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import {
  MAX_THROTTLE_WAIT_MS,
  PushCampaignJobData,
} from '../../queue/queue.constants';
import {
  CAMPAIGN_STOPPED_BY_SUSPENSION,
  ProjectSuspensionService,
} from '../projects/project-suspension.service';
import { SmsAudienceService } from './sms-audience.service';
import { SmsSettingsService } from './sms-settings.service';
import { SmsProviderRegistry } from './sms-provider.registry';
import { renderSms, SmsMessage } from './sms-rendering';
import { SmsSettingsEntity } from './entities/sms-settings.entity';
import { TWILIO_UNREACHABLE, TWILIO_UNSUBSCRIBED } from './providers/twilio.provider';

/** Recipients per page. As for email: one HTTP call each, so kept small. */
export const SMS_BATCH_SIZE = 100;

/**
 * Delivers one SMS campaign. Called by the campaign processor for rows with
 * `channel = 'sms'`.
 *
 * The email walk with a different reader and message: keyset pages over
 * identities with a reachable number, a checkpoint over the provider's
 * resolved prefix, and a thrown error — retried from that checkpoint — when
 * the provider stops short.
 */
@Injectable()
export class SmsDeliveryService {
  private readonly logger = new Logger(SmsDeliveryService.name);

  constructor(
    @InjectRepository(PushConfigEntity)
    private readonly policyRepository: Repository<PushConfigEntity>,
    private readonly state: PushCampaignStateService,
    private readonly settings: SmsSettingsService,
    private readonly audience: SmsAudienceService,
    private readonly registry: SmsProviderRegistry,
    private readonly suppressions: SuppressionsService,
    private readonly suspension: ProjectSuspensionService,
  ) {}

  async deliver(
    job: Job<PushCampaignJobData>,
    log: PushNotificationLogEntity,
  ): Promise<void> {
    if (!log.body?.trim()) {
      await this.state.markFailed(log.id, 'This SMS campaign has no text.');
      throw new UnrecoverableError(`SMS campaign ${log.id} has no text`);
    }

    let sendable: Awaited<ReturnType<SmsSettingsService['requireSendable']>>;
    try {
      sendable = await this.settings.requireSendable(log.projectId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'SMS is not configured';
      await this.state.markFailed(log.id, detail);
      throw new UnrecoverableError(detail);
    }
    const { settings, credentials } = sendable;
    const provider = this.registry.get(settings.provider);

    const policy = await this.policyRepository.findOne({
      where: { projectId: log.projectId },
    });
    const cap = policy?.frequencyCapPerDay ?? null;
    const maxPerMinute = policy?.maxSendsPerMinute ?? null;

    const scope = {
      projectId: log.projectId,
      // Only `project` fans out; anything else is its stored list, and a
      // missing list reaches nobody.
      deviceIdentityIds: log.targetType === 'project' ? null : (log.targetDeviceIds ?? []),
      requireOptIn: settings.requireOptIn,
    };

    await this.state.markSending(log.id);

    let cursor: string | null = log.lastTokenId;
    let processed = log.processedTokens;

    for (;;) {
      const page = await this.audience.page(scope, cursor, SMS_BATCH_SIZE, cap, log.id);
      if (page.length === 0) break;

      // Per page, not per job: a large campaign runs for hours and suspension
      // is often urgent. Checked after the empty-page break so a campaign that
      // has already reached everyone still finishes as what it is. Returning
      // rather than throwing completes the job, so BullMQ spends no retries and
      // `markFailed` keeps what was delivered honest (`partial` or `failed`).
      if (await this.suspension.isSuspended(log.projectId)) {
        await this.state.markFailed(log.id, CAMPAIGN_STOPPED_BY_SUSPENSION);
        this.logger.warn(`SMS campaign ${log.id} stopped: its tenant is suspended`);
        return;
      }

      const recipients = this.buildRecipients(log, page, settings);
      const result = await provider.sendToRecipients(credentials, recipients);

      if (result.resolvedCount > 0) {
        const resolved = page.slice(0, result.resolvedCount);
        const failed = new Set(result.failures.map((failure) => failure.token));

        await this.state.recordSentRecipients(
          log,
          resolved
            .filter((identity) => !failed.has(identity.phoneE164!))
            .map((identity) => identity.id),
        );
        await this.suppressDeadNumbers(log.projectId, settings.provider, result.failures);

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
            `recipients of SMS campaign ${log.id}: ${result.retryReason}`,
        );
      }
    }

    const status = await this.state.finalize(log.id);
    this.logger.log(`SMS campaign ${log.id} finished with status ${status}`);
  }

  /**
   * Suppresses numbers the provider says will never take a text, so the next
   * campaign neither pays for nor counts them.
   *
   * Twilio refuses a number that replied STOP with 21610 even when the STOP
   * never reached Chumbaq — the inbound webhook was not set up, or the reply
   * went to another number in a Messaging Service — so this is also the
   * backstop that keeps the suppression list honest.
   */
  private async suppressDeadNumbers(
    projectId: string,
    source: string,
    failures: ChannelFailure[],
  ): Promise<void> {
    const entries = failures.flatMap((failure): Array<{
      address: string;
      reason: SuppressionReason;
      detail: string;
    }> => {
      if (failure.errorCode === TWILIO_UNSUBSCRIBED) {
        return [{ address: failure.token, reason: 'unsubscribed', detail: failure.error }];
      }
      if (failure.errorCode && TWILIO_UNREACHABLE.has(failure.errorCode)) {
        return [{ address: failure.token, reason: 'bounced', detail: failure.error }];
      }
      return [];
    });
    if (entries.length > 0) {
      await this.suppressions.suppress(projectId, 'sms', entries, source);
    }
  }

  private buildRecipients(
    log: PushNotificationLogEntity,
    page: DeviceIdentityEntity[],
    settings: SmsSettingsEntity,
  ): ChannelRecipient<SmsMessage>[] {
    return page.map((identity) => ({
      token: identity.phoneE164!,
      message: renderSms({
        body: log.body!,
        identity,
        from: settings.sender,
        optOutText: settings.optOutText,
        statusCallback: this.settings.statusCallbackUrl(settings, log.id, identity.id),
      }),
    }));
  }

  private async throttle(sent: number, maxPerMinute: number | null): Promise<void> {
    if (!maxPerMinute || maxPerMinute <= 0 || sent <= 0) return;
    const waitMs = Math.min((sent / maxPerMinute) * 60_000, MAX_THROTTLE_WAIT_MS);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

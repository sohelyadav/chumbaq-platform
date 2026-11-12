import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { PushConfigEntity } from '../push-notifications/entities/push-config.entity';
import { PushCampaignStateService } from '../push-notifications/push-campaign-state.service';
import { SuppressionsService } from '../push-notifications/suppressions.service';
import { ChannelRecipient } from '../push-notifications/services/channel-provider';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import {
  MAX_THROTTLE_WAIT_MS,
  PushCampaignJobData,
} from '../../queue/queue.constants';
import {
  CAMPAIGN_STOPPED_BY_SUSPENSION,
  ProjectSuspensionService,
} from '../projects/project-suspension.service';
import { WhatsAppAudienceService } from './whatsapp-audience.service';
import { WhatsAppSettingsService } from './whatsapp-settings.service';
import { WhatsAppProviderRegistry } from './whatsapp-provider.registry';
import { renderWhatsApp, WhatsAppMessage } from './whatsapp-rendering';

/** Recipients per page: one HTTP call each, as for email and SMS. */
export const WHATSAPP_BATCH_SIZE = 100;

/**
 * Delivers one WhatsApp campaign. Called by the campaign processor for rows
 * with `channel = 'whatsapp'` — the SMS walk with templates for messages.
 */
@Injectable()
export class WhatsAppDeliveryService {
  private readonly logger = new Logger(WhatsAppDeliveryService.name);

  constructor(
    @InjectRepository(PushConfigEntity)
    private readonly policyRepository: Repository<PushConfigEntity>,
    private readonly state: PushCampaignStateService,
    private readonly settings: WhatsAppSettingsService,
    private readonly audience: WhatsAppAudienceService,
    private readonly registry: WhatsAppProviderRegistry,
    private readonly suppressions: SuppressionsService,
    private readonly suspension: ProjectSuspensionService,
  ) {}

  async deliver(
    job: Job<PushCampaignJobData>,
    log: PushNotificationLogEntity,
  ): Promise<void> {
    if (!log.whatsappContent) {
      await this.state.markFailed(log.id, 'This WhatsApp campaign has no template.');
      throw new UnrecoverableError(`WhatsApp campaign ${log.id} has no template`);
    }

    let sendable: Awaited<ReturnType<WhatsAppSettingsService['requireSendable']>>;
    try {
      sendable = await this.settings.requireSendable(log.projectId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'WhatsApp is not configured';
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
      deviceIdentityIds: log.targetType === 'project' ? null : (log.targetDeviceIds ?? []),
      requireOptIn: settings.requireOptIn,
    };

    await this.state.markSending(log.id);

    let cursor: string | null = log.lastTokenId;
    let processed = log.processedTokens;

    for (;;) {
      const page = await this.audience.page(scope, cursor, WHATSAPP_BATCH_SIZE, cap, log.id);
      if (page.length === 0) break;

      // Per page, not per job: a large campaign runs for hours and suspension
      // is often urgent. Checked after the empty-page break so a campaign that
      // has already reached everyone still finishes as what it is. Returning
      // rather than throwing completes the job, so BullMQ spends no retries and
      // `markFailed` keeps what was delivered honest (`partial` or `failed`).
      if (await this.suspension.isSuspended(log.projectId)) {
        await this.state.markFailed(log.id, CAMPAIGN_STOPPED_BY_SUSPENSION);
        this.logger.warn(`WhatsApp campaign ${log.id} stopped: its tenant is suspended`);
        return;
      }

      const recipients = this.buildRecipients(log, page, settings.webhookToken, settings.provider);
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

        const dead = result.failures.flatMap((failure) => {
          const reason = failure.errorCode
            ? provider.suppressingErrors.get(failure.errorCode)
            : undefined;
          return reason ? [{ address: failure.token, reason, detail: failure.error }] : [];
        });
        if (dead.length > 0) {
          await this.suppressions.suppress(log.projectId, 'whatsapp', dead, settings.provider);
        }

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
            `recipients of WhatsApp campaign ${log.id}: ${result.retryReason}`,
        );
      }
    }

    const status = await this.state.finalize(log.id);
    this.logger.log(`WhatsApp campaign ${log.id} finished with status ${status}`);
  }

  private buildRecipients(
    log: PushNotificationLogEntity,
    page: DeviceIdentityEntity[],
    webhookToken: string,
    providerName: string,
  ): ChannelRecipient<WhatsAppMessage>[] {
    const callback =
      providerName === 'twilio_whatsapp' && this.settings.webhooksReachable()
        ? this.settings.webhookUrl(webhookToken, 'twilio_whatsapp')
        : undefined;
    return page.map((identity) => ({
      token: identity.phoneE164!,
      message: renderWhatsApp({
        content: log.whatsappContent!,
        identity,
        campaignId: log.id,
        identityId: identity.id,
        statusCallback: callback
          ? `${callback}?${new URLSearchParams({ c: log.id, i: identity.id })}`
          : undefined,
      }),
    }));
  }

  private async throttle(sent: number, maxPerMinute: number | null): Promise<void> {
    if (!maxPerMinute || maxPerMinute <= 0 || sent <= 0) return;
    const waitMs = Math.min((sent / maxPerMinute) * 60_000, MAX_THROTTLE_WAIT_MS);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

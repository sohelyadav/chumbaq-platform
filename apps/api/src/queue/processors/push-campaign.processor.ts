import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import {
  MAX_THROTTLE_WAIT_MS,
  QUEUE_PUSH_CAMPAIGN,
  PUSH_BATCH_SIZE,
  PushCampaignJobData,
} from '../queue.constants';
import {
  PushNotificationLogEntity,
  TERMINAL_STATUSES,
} from '../../modules/push-notifications/entities/push-notification-log.entity';
import { PushConfigEntity } from '../../modules/push-notifications/entities/push-config.entity';
import { PushProvider } from '../../modules/push-tokens/entities/push-token.entity';
import { resolveTimer } from '../../modules/push-notifications/rich-content';
import { ChannelProviderRegistry } from '../../modules/push-notifications/services/channel-provider.registry';
import { ChannelCredentialsService } from '../../modules/push-notifications/channel-credentials.service';
import { PushCampaignStateService } from '../../modules/push-notifications/push-campaign-state.service';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import {
  FcmProvider,
  ServiceAccountCredentials,
} from '../../modules/push-notifications/services/fcm.provider';
import { PushTokensService } from '../../modules/push-tokens/push-tokens.service';
import { PushTokenEntity } from '../../modules/push-tokens/entities/push-token.entity';
import { IdentityService } from '../../modules/identity/identity.service';
import {
  hasPersonalisation,
  personalise,
  pickTranslation,
} from '../../modules/push-notifications/push-personalisation';
import {
  CampaignMessage,
  ChannelRecipient,
} from '../../modules/push-notifications/services/channel-provider';
import { EmailDeliveryService } from '../../modules/email/email-delivery.service';
import { SmsDeliveryService } from '../../modules/sms/sms-delivery.service';
import { WhatsAppDeliveryService } from '../../modules/whatsapp/whatsapp-delivery.service';
import {
  CAMPAIGN_STOPPED_BY_SUSPENSION,
  ProjectSuspensionService,
} from '../../modules/projects/project-suspension.service';

/**
 * Delivers a queued push campaign.
 *
 * Tokens are walked one keyset page at a time and the cursor is persisted after
 * every batch, so a crash or deploy mid-campaign resumes from the last
 * checkpoint rather than restarting (which would re-notify everyone already
 * reached) or dying silently.
 */
@Processor(QUEUE_PUSH_CAMPAIGN, { concurrency: 2 })
export class PushCampaignProcessor extends WorkerHost {
  private readonly logger = new Logger(PushCampaignProcessor.name);

  constructor(
    @InjectRepository(PushNotificationLogEntity)
    private readonly logRepository: Repository<PushNotificationLogEntity>,
    @InjectRepository(PushConfigEntity)
    private readonly configRepository: Repository<PushConfigEntity>,
    private readonly state: PushCampaignStateService,
    private readonly cryptoService: CredentialsCryptoService,
    private readonly fcmProvider: FcmProvider,
    private readonly channelRegistry: ChannelProviderRegistry,
    private readonly channelCredentials: ChannelCredentialsService,
    private readonly pushTokensService: PushTokensService,
    private readonly identityService: IdentityService,
    private readonly emailDelivery: EmailDeliveryService,
    private readonly smsDelivery: SmsDeliveryService,
    private readonly whatsappDelivery: WhatsAppDeliveryService,
    private readonly suspension: ProjectSuspensionService,
  ) {
    super();
  }

  async process(job: Job<PushCampaignJobData>): Promise<void> {
    const { logId } = job.data;

    const log = await this.logRepository.findOne({ where: { id: logId } });
    if (!log) {
      throw new UnrecoverableError(`Push campaign log ${logId} no longer exists`);
    }

    // Idempotency: BullMQ can redeliver after a stalled-job reclaim. A finished
    // campaign must never be re-sent.
    if (TERMINAL_STATUSES.includes(log.status)) {
      this.logger.warn(`Campaign ${logId} already ${log.status}; skipping`);
      return;
    }

    // Ahead of the channel split, so it covers every channel, and ahead of any
    // setup check, so a suspended tenant's campaign is not reported as a missing
    // configuration. Each walk checks again before every page.
    if (await this.suspension.isSuspended(log.projectId)) {
      await this.state.markFailed(logId, CAMPAIGN_STOPPED_BY_SUSPENSION);
      this.logger.warn(`Campaign ${logId} not started: its tenant is suspended`);
      return;
    }

    // One queue and one job for every channel, so scheduling, retries,
    // stall recovery and reconciliation are shared. Only the walk differs:
    // email, SMS and WhatsApp read addresses instead of tokens.
    if (log.channel === 'email') {
      return this.emailDelivery.deliver(job, log);
    }
    if (log.channel === 'sms') {
      return this.smsDelivery.deliver(job, log);
    }
    if (log.channel === 'whatsapp') {
      return this.whatsappDelivery.deliver(job, log);
    }

    const { frequencyCapPerDay, maxSendsPerMinute } = await this.loadConfig(log);
    const credentialsByChannel = new Map<PushProvider, unknown>();

    // Only channels this project holds credentials for are eligible. A device
    // registered on a channel the project cannot send through would otherwise
    // be selected and take the whole campaign down when its credentials are
    // read — and, worse, suppress the channel that does work for that device.
    const deliverable = await this.channelCredentials.configuredPushProviders(
      log.projectId,
    );

    // With no configured channel there is nothing to select on, so the token
    // walk ends on an empty first page and the campaign is reported as having
    // run out of tokens. Fail here instead, where the cause is still known:
    // the fix is adding credentials in Settings, not anything to do with the
    // token table. Unrecoverable because no retry will conjure credentials.
    if (deliverable.length === 0) {
      const detail =
        'No push channel is configured for this project, so nothing could be sent. ' +
        'Add channel credentials in Settings and send again.';
      await this.state.markFailed(logId, detail);
      throw new UnrecoverableError(
        `No configured push channel for project ${log.projectId}`,
      );
    }

    await this.state.markSending(logId);

    const message: CampaignMessage = {
      title: log.title,
      body: log.body ?? undefined,
      data: log.data ?? undefined,
      imageUrl: log.imageUrl ?? undefined,
      // Lets the device report delivery and clicks back against this campaign.
      campaignId: log.id,
      deepLinkUrl: log.deepLinkUrl ?? undefined,
      silent: log.silent,
      options: log.deliveryOptions ?? undefined,
      actions: log.actions ?? undefined,
      iosCategory: log.iosCategory ?? undefined,
      carousel: log.carousel ?? undefined,
      // Resolved here rather than when the campaign was written, because a
      // relative countdown is measured from when this particular send goes
      // out — which is what lets each recurring occurrence and each timezone
      // wave carry its own deadline instead of inheriting the first one's.
      // The device is still told one absolute moment.
      timer: log.timer ? (resolveTimer(log.timer, new Date()) ?? undefined) : undefined,
    };

    // Resume from the checkpoint, not from the beginning.
    let cursor: string | null = log.lastTokenId;
    let processed = log.processedTokens;

    for (;;) {
      const page = await this.nextPage(
        log,
        cursor,
        frequencyCapPerDay,
        deliverable,
      );
      if (page.length === 0) break;

      // Per page, not per job: a large campaign runs for hours and suspension
      // is often urgent. Checked after the empty-page break so a campaign that
      // has already reached everyone still finishes as what it is. Returning
      // rather than throwing completes the job, so BullMQ spends no retries and
      // `markFailed` keeps what was delivered honest (`partial` or `failed`).
      if (await this.suspension.isSuspended(log.projectId)) {
        await this.state.markFailed(log.id, CAMPAIGN_STOPPED_BY_SUSPENSION);
        this.logger.warn(`Campaign ${log.id} stopped: its tenant is suspended`);
        return;
      }

      // A page is narrowed to the leading run of tokens sharing one channel,
      // because `resolvedCount` describes a prefix and the cursor advances
      // through it. Across two channels there is no single prefix to advance
      // through, so the next iteration picks the next channel up rather than
      // interleaving them. Today every token is FCM and the run is the whole
      // page; this is what makes a second channel a drop-in.
      const channel = page[0].provider;
      const boundary = page.findIndex((token) => token.provider !== channel);
      const run = boundary === -1 ? page : page.slice(0, boundary);

      const result = await this.channelRegistry
        .get(channel)
        .sendToRecipients(
          await this.credentialsFor(log, channel, credentialsByChannel),
          await this.buildRecipients(log, run, message),
        );

      // Closed out in one project-scoped UPDATE rather than one awaited call
      // per failure: an unscoped `WHERE token = ?` cannot use the composite
      // (project_id, token) index, so the per-failure form was up to 500
      // sequential scans running serially ahead of every checkpoint.
      //
      // Matched on FCM's parsed errorCode rather than on a substring of the
      // raw response body, so a token is only deactivated because FCM said
      // it is gone.
      const unregistered = result.failures
        .filter(
          (failure) =>
            failure.errorCode === 'UNREGISTERED' ||
            failure.errorCode === 'NOT_FOUND',
        )
        .map((failure) => failure.token);

      if (unregistered.length > 0) {
        await this.pushTokensService.markTokensInvalid(
          log.projectId,
          unregistered,
        );
      }

      // Checkpoint only what FCM resolved. `resolvedCount` stops at the first
      // token that is still failing for a retryable reason, so the cursor can
      // never step over a recipient who has not actually been given up on.
      if (result.resolvedCount > 0) {
        // Only when a cap is configured: this is one row per recipient per
        // campaign, and a project that does not cap should not pay for it.
        if (frequencyCapPerDay !== null) {
          const failed = new Set(result.failures.map((f) => f.token));
          await this.state.recordSentRecipients(
            log,
            run
              .slice(0, result.resolvedCount)
              .filter((token) => !failed.has(token.token))
              .map((token) => token.deviceIdentityId),
          );
        }

        cursor = run[result.resolvedCount - 1].id;
        processed += result.resolvedCount;

        await this.state.recordBatch(logId, {
          successCount: result.successCount,
          failureCount: result.failureCount,
          // `retryable` is routing information for this method and is dropped,
          // but errorCode is kept: it is what any reader actually needs, and
          // recovering it later means re-parsing FCM's raw error envelope.
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

      /**
       * Sustained throttling ends the attempt rather than the campaign.
       *
       * The provider already retried this token with backoff, so reaching here
       * means FCM is still refusing. Throwing hands the wait to BullMQ, whose
       * exponential backoff is measured in seconds rather than milliseconds,
       * and the retry resumes from the checkpoint just written. Continuing the
       * walk instead would advance past this token and drop the recipient with
       * nothing left to retry them — which is exactly what the old code did,
       * silently, while reporting the campaign as complete.
       */
      await this.throttle(result.resolvedCount, maxSendsPerMinute);

      if (result.retryReason) {
        throw new Error(
          `FCM still failing for campaign ${logId} after ` +
            `${result.resolvedCount}/${page.length} tokens in this page: ` +
            result.retryReason,
        );
      }
    }

    const status = await this.state.finalize(logId);
    this.logger.log(`Campaign ${logId} finished with status ${status}`);
  }

  /**
   * BullMQ fires `failed` after every failed attempt, not only the last one.
   * Marking the campaign terminally failed has to wait for retries to be
   * exhausted here rather than in a `catch` inside `process()`: a `catch`
   * would run *between* retries, so the row would go terminal, and the R7
   * idempotency guard at the top of `process()` would then see the retry as
   * an already-terminal campaign and silently drop it instead of resuming —
   * turning a transient FCM/network blip into a permanently half-sent
   * campaign. `job.attemptsMade` is only correct here: inside `process()` it
   * counts prior attempts and is off by one on the final try, whereas by the
   * time this event fires BullMQ has already incremented it for the attempt
   * that just failed.
   *
   * The `UnrecoverableError` throws in `loadCredentials` already call
   * `markFailed` inline before throwing, and an unrecoverable error fails
   * the job on its first attempt without consuming the rest — so
   * `attemptsMade` stays below `attempts` there and the guard below no-ops,
   * avoiding a duplicate write.
   *
   * The guard is still only a proxy for "BullMQ will try again", and it is
   * wrong for any terminal path that does not consume an attempt — a repeat
   * stall under `maxStalledCount: 1` is the known one. Those campaigns are
   * caught by PushCampaignReconciliationScheduler rather than by widening
   * this condition, which would have to anticipate every such path.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<PushCampaignJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;

    await this.state.markFailed(
      job.data.logId,
      `Push campaign ${job.data.logId} failed after ${job.attemptsMade} attempt(s): ${error.message}`,
    );
  }

  /**
   * Project sending policy.
   *
   * Credentials are deliberately not loaded here. Which channel a page goes
   * out on is only known once its tokens are read, and each channel has its
   * own credentials — loading one channel's up front is how a Mi Push send
   * ends up handed a Firebase service account.
   */
  private async loadConfig(
    log: PushNotificationLogEntity,
  ): Promise<{
    frequencyCapPerDay: number | null;
    maxSendsPerMinute: number | null;
  }> {
    const config = await this.configRepository.findOne({
      where: { projectId: log.projectId, isActive: true },
    });

    if (!config) {
      await this.state.markFailed(
        log.id,
        'Push configuration missing or inactive',
      );
      throw new UnrecoverableError(
        `No active push config for project ${log.projectId}`,
      );
    }

    return {
      frequencyCapPerDay: config.frequencyCapPerDay ?? null,
      maxSendsPerMinute: config.maxSendsPerMinute ?? null,
    };
  }

  /**
   * Credentials for one channel, read once per campaign rather than per page.
   *
   * A campaign can span channels — a device on Mi Push and a device on FCM are
   * two runs of the same audience — so this is keyed by channel and memoised
   * for the life of the job.
   */
  private async credentialsFor(
    log: PushNotificationLogEntity,
    channel: PushProvider,
    cache: Map<PushProvider, unknown>,
  ): Promise<unknown> {
    const cached = cache.get(channel);
    if (cached !== undefined) return cached;

    let plaintext: string | null;
    try {
      plaintext = await this.channelCredentials.getPlaintext(
        log.projectId,
        channel,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      await this.state.markFailed(
        log.id,
        `Could not read ${channel} credentials: ${detail}`,
      );
      throw new UnrecoverableError(detail);
    }

    if (plaintext === null) {
      // Tokens exist for this channel, so recipients are waiting on it. Failing
      // the campaign is right: sending nothing while reporting success would
      // hide the missing configuration behind a campaign that looks delivered.
      const detail = `No ${channel} credentials configured for this project`;
      await this.state.markFailed(log.id, detail);
      throw new UnrecoverableError(detail);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      const detail = `Stored ${channel} credentials are not readable`;
      await this.state.markFailed(log.id, detail);
      throw new UnrecoverableError(detail);
    }

    cache.set(channel, parsed);
    return parsed;
  }

  /**
   * Paces delivery to the project's configured rate.
   *
   * Applied after a page rather than between individual sends: the provider
   * already caps concurrency, so the page is the natural unit, and sleeping
   * once per page keeps the worker off the event loop instead of thousands of
   * short timers.
   *
   * The wait is bounded. A pathologically low rate should slow a campaign
   * down, not park a worker for an hour holding a job lock that BullMQ will
   * then reclaim as stalled.
   */
  private async throttle(
    sentInPage: number,
    maxSendsPerMinute: number | null,
  ): Promise<void> {
    if (!maxSendsPerMinute || maxSendsPerMinute <= 0 || sentInPage <= 0) return;

    const idealMs = (sentInPage / maxSendsPerMinute) * 60_000;
    const waitMs = Math.min(idealMs, MAX_THROTTLE_WAIT_MS);
    if (waitMs <= 0) return;

    this.logger.debug(
      `Throttling ${waitMs}ms after ${sentInPage} sends to stay under ${maxSendsPerMinute}/min`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  /**
   * Pairs each token with the message that token should receive.
   *
   * Only campaigns whose copy actually contains `{{tokens}}` pay for the
   * identity lookup — everything else shares one message object, exactly as
   * before. When it is needed, the whole page is resolved in one query rather
   * than one per token, since a page is up to 500.
   *
   * A person whose identity has since been deleted still receives the
   * campaign, rendered with fallbacks: dropping a recipient because we could
   * not personalise for them would silently shrink the audience.
   */
  private async buildRecipients(
    log: PushNotificationLogEntity,
    page: PushTokenEntity[],
    message: CampaignMessage,
  ): Promise<ChannelRecipient[]> {
    // Either feature needs the identity behind each token: translations to
    // pick the recipient's language, personalisation to fill their name.
    const needsTranslation = !!log.translations;
    if (
      !needsTranslation &&
      !hasPersonalisation(log.title, log.body, log.deepLinkUrl)
    ) {
      return page.map((token) => ({ token: token.token, message }));
    }

    const identities = await this.identityService.findByIds(
      page.map((token) => token.deviceIdentityId),
    );
    const byId = new Map(identities.map((identity) => [identity.id, identity]));

    return page.map((token) => {
      const person = byId.get(token.deviceIdentityId) ?? null;

      // Translate first, then personalise: tokens live inside the translated
      // copy, so substituting before choosing the language would fill in the
      // wrong string and then throw it away.
      const translation = pickTranslation(log.translations, person);
      const title = translation?.title ?? log.title;
      const body = translation?.body ?? log.body;

      return {
        token: token.token,
        message: {
          ...message,
          title: personalise(title, person) ?? title,
          body: personalise(body, person),
          deepLinkUrl: personalise(log.deepLinkUrl, person),
        },
      };
    });
  }

  /**
   * Selects the token reader for the campaign's audience.
   *
   * Written as "only `project` fans out", never as "only `devices` is
   * targeted". Both `devices` and `segment` carry a resolved
   * `targetDeviceIds` list, and an earlier form that named `devices` alone
   * let `segment` fall through to every active token in the project — a
   * 50-person segment sending to the whole install base, silently and
   * irreversibly. Phrased this way, a target type added later defaults to the
   * narrow reader (an empty id list sends to nobody) rather than to the blast.
   */
  private nextPage(
    log: PushNotificationLogEntity,
    cursor: string | null,
    frequencyCap: number | null,
    deliverable: PushProvider[],
  ): Promise<PushTokenEntity[]> {
    return log.targetType === 'project'
      ? this.pushTokensService.getActiveTokensPage(
          log.projectId,
          cursor,
          PUSH_BATCH_SIZE,
          frequencyCap,
          log.id,
          deliverable,
        )
      : this.pushTokensService.getTokensByDeviceIdentityIdsPage(
          log.projectId,
          log.targetDeviceIds ?? [],
          cursor,
          PUSH_BATCH_SIZE,
          frequencyCap,
          log.id,
          deliverable,
        );
  }
}

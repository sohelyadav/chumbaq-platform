import {
  Injectable,
  NotFoundException,
  BadRequestException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { PushConfigEntity } from './entities/push-config.entity';
import type { PushProvider } from '../push-tokens/entities/push-token.entity';
import type { ActivityContext } from '../project-activity/activity-context';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { changedFields } from '../project-activity/changed-fields';
import { channelTarget, providerTarget } from '../project-activity/channel-targets';
import {
  campaignEntry,
  heldOrSent,
  recordBy,
  type ActivityRequester,
} from '../project-activity/messaging-activity';
import { saveCampaign, type CampaignLogging } from './save-campaign';
import { MessageChannel } from './message-channel';
import { PushNotificationLogEntity } from './entities/push-notification-log.entity';
import {
  PushAnalyticsService,
  CampaignEngagement,
} from './push-analytics.service';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { validateVariants } from './variant-assignment';
import { validateRecurrence, nextOccurrence } from './recurrence';
import { validateCarousel, validateTimer } from './rich-content';
import { PushTemplatesService } from './push-templates.service';
import { ChannelCredentialsService } from './channel-credentials.service';
import {
  FcmProvider,
  ServiceAccountCredentials,
} from './services/fcm.provider';
import { PushTokensService } from '../push-tokens/push-tokens.service';
import { IdentityService } from '../identity/identity.service';
import { logValue } from '../../common/log-value';
import { SegmentsService } from '../segments/segments.service';
import {
  SegmentEvaluationService,
  SEGMENT_SEND_MAX_PEOPLE,
} from '../segments/segment-evaluation.service';
import { SegmentEntity } from '../segments/entities/segment.entity';
import {
  ConfigurePushDto,
  SendPushNotificationDto,
  SendToUserDto,
  TestSendPushDto,
  PreviewAudienceDto,
  UpdatePushSettingsDto,
} from './dto/push-notification.dto';
import {
  QUEUE_PUSH_CAMPAIGN,
  JOB_DISPATCH_CAMPAIGN,
  PushCampaignJobData,
} from '../../queue/queue.constants';

/** How the activity log names a push provider. */
const PUSH_PROVIDER_LABELS: Record<PushProvider, string> = {
  fcm: 'Firebase Cloud Messaging',
  apns: 'Apple Push Notification service',
  mi_push: 'Mi Push',
  huawei: 'Huawei Push Kit',
  oppo: 'OPPO Push',
  vivo: 'vivo Push',
  honor: 'HONOR Push',
};

@Injectable()
export class PushNotificationsService {
  private readonly logger = new Logger(PushNotificationsService.name);

  constructor(
    @InjectRepository(PushConfigEntity)
    private readonly configRepository: Repository<PushConfigEntity>,
    @InjectRepository(PushNotificationLogEntity)
    private readonly logRepository: Repository<PushNotificationLogEntity>,
    private readonly cryptoService: CredentialsCryptoService,
    private readonly fcmProvider: FcmProvider,
    private readonly pushTokensService: PushTokensService,
    private readonly identityService: IdentityService,
    private readonly segmentsService: SegmentsService,
    private readonly segmentEvaluation: SegmentEvaluationService,
    private readonly pushAnalytics: PushAnalyticsService,
    private readonly pushTemplates: PushTemplatesService,
    private readonly channelCredentials: ChannelCredentialsService,
    @InjectQueue(QUEUE_PUSH_CAMPAIGN)
    private readonly pushQueue: Queue<PushCampaignJobData>,
    private readonly activity: ProjectActivityService,
  ) {}

  /**
   * Stores a push channel's credentials (already checked by its provider) and logs
   * `channel.credentials_uploaded` in the same transaction, naming the provider and the
   * field `credentials`, never what they hold. Credentials the channel already holds,
   * compared decrypted, are neither written nor logged.
   */
  async storeChannelCredentials(
    projectId: string,
    provider: PushProvider,
    plaintext: string,
    actorId: string,
    ctx: ActivityContext,
  ): Promise<void> {
    await this.configRepository.manager.transaction(async (manager) => {
      // The projects row first, as every project transaction takes it (lock order).
      await manager.query('SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE', [projectId]);
      const changed = await this.channelCredentials.replace(manager, projectId, provider, plaintext);
      if (!changed) return;
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'channel.credentials_uploaded',
          target: providerTarget(provider, PUSH_PROVIDER_LABELS[provider]),
          details: { channel: 'push', fields: ['credentials'] },
        },
        ctx,
        manager,
      );
    });
  }

  /**
   * The FCM upload. Logged as `channel.credentials_uploaded` when it changes the stored
   * service account or switches push back on; a re-upload of the same one is not.
   */
  async configure(
    dto: ConfigurePushDto,
    actorId: string,
    ctx: ActivityContext,
  ): Promise<{ id: string; projectId: string; firebaseProjectId: string }> {
    // Validate JSON structure
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dto.fcmServiceAccountJson);
    } catch {
      throw new BadRequestException('Invalid JSON for FCM service account');
    }

    if (!parsed.project_id || !parsed.private_key || !parsed.client_email) {
      throw new BadRequestException(
        'FCM service account must include project_id, private_key, and client_email',
      );
    }

    // Prove the key actually mints a Firebase token before storing it.
    // Structural validation passes for a truncated or wrong-project private
    // key, and without this the first sign that a service account is bad is a
    // campaign failing hours later, with the error buried in worker logs.
    try {
      await this.fcmProvider.validateCredentials(
        parsed as unknown as ServiceAccountCredentials,
      );
    } catch (error) {
      // Our own refusal (a token_uri that is not Google's) already says what
      // is wrong; it is not Firebase's verdict.
      if (error instanceof HttpException) throw error;
      // The provider's messages carry a status and an OAuth error code only,
      // never Google's response body, so they are safe to show here.
      const detail = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(
        `Firebase rejected this service account: ${detail}`,
      );
    }

    // The config row now carries only sending policy — frequency cap, quiet
    // hours, rate limit — so it is created empty on first configure and left
    // alone on re-upload, which must not reset those settings.
    const config = await this.configRepository.manager.transaction(async (manager) => {
      // The projects row first, as every project transaction takes it (lock order).
      await manager.query('SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE', [dto.projectId]);
      const changed = await this.channelCredentials.replace(
        manager,
        dto.projectId,
        'fcm',
        dto.fcmServiceAccountJson,
      );
      const configs = manager.getRepository(PushConfigEntity);
      let row = await configs.findOne({
        where: { projectId: dto.projectId },
        lock: { mode: 'pessimistic_write' },
      });
      const switchedOn = !row?.isActive;
      if (row) {
        if (!row.isActive) {
          row.isActive = true;
          row = await configs.save(row);
        } else if (changed) {
          // The dashboard shows this row's updated_at as when the service account was
          // last replaced, and the credentials live in another table. Only this
          // column, so the sending policy on the row is left as it is.
          row.updatedAt = new Date();
          await configs.update({ id: row.id }, { updatedAt: row.updatedAt });
        }
      } else {
        row = await configs.save(
          configs.create({
            projectId: dto.projectId,
            isActive: true,
          } as Partial<PushConfigEntity>) as PushConfigEntity,
        );
      }
      if (changed || switchedOn) {
        await this.activity.record(
          {
            projectId: dto.projectId,
            actor: { kind: 'user', userId: actorId },
            action: 'channel.credentials_uploaded',
            target: providerTarget('fcm', PUSH_PROVIDER_LABELS.fcm),
            details: { channel: 'push', fields: ['credentials'] },
          },
          ctx,
          manager,
        );
      }
      return row;
    });

    // firebaseProjectId echoes back which Firebase project the uploaded key
    // belongs to, so a key pasted from the wrong project is visible at once.
    return {
      id: config.id,
      projectId: config.projectId,
      firebaseProjectId: parsed.project_id as string,
    };
  }

  /**
   * Sends one notification to one token and reports the outcome inline, rather
   * than queueing a campaign and leaving the caller to read logs.
   */
  async testSend(dto: TestSendPushDto): Promise<{
    delivered: boolean;
    dryRun: boolean;
    error?: string;
    errorCode?: string;
  }> {
    const config = await this.configRepository.findOne({
      where: { projectId: dto.projectId, isActive: true },
    });

    if (!config) {
      throw new NotFoundException(
        'Push notifications not configured for this project. Call configure first.',
      );
    }

    const dryRun = dto.dryRun ?? false;

    // A test send is still a notification on a real person's screen, so an
    // explicit opt-out holds here too. A dry run is left alone: the provider
    // validates it and delivers nothing, and it is how credentials are
    // checked against whatever token is to hand.
    if (
      !dryRun &&
      (await this.pushTokensService.isTokenOptedOut(dto.projectId, dto.token))
    ) {
      return {
        delivered: false,
        dryRun,
        error: 'This device has opted out of push notifications.',
        errorCode: 'opted_out',
      };
    }

    // Reporting rather than throwing: a stored service account that Google
    // rejects makes `send` throw before any token is attempted, and a 500 is
    // the wrong answer from the endpoint whose entire job is to tell you what
    // is wrong with your setup.
    let result: Awaited<ReturnType<FcmProvider['send']>>;
    try {
      result = await this.fcmProvider.send(
        await this.decryptCredentials(dto.projectId),
        [dto.token],
        {
          title: dto.title ?? 'Chumbaq test',
          body: dto.body ?? 'Push notifications are configured correctly.',
        },
        { dryRun },
      );
    } catch (error) {
      return {
        delivered: false,
        dryRun,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    if (result.successCount === 1) {
      return { delivered: true, dryRun };
    }

    // A failure that is still retryable never reaches `failures` — the
    // provider reports it as `retryReason` instead — so both are consulted.
    const failure = result.failures[0];
    return {
      delivered: false,
      dryRun,
      error: failure?.error ?? result.retryReason ?? 'Unknown error',
      errorCode: failure?.errorCode,
    };
  }

  private async decryptCredentials(
    projectId: string,
  ): Promise<ServiceAccountCredentials> {
    const plaintext = await this.channelCredentials.getPlaintext(
      projectId,
      'fcm',
    );
    if (plaintext === null) {
      throw new NotFoundException(
        'Push notifications are not configured for this project.',
      );
    }
    try {
      return JSON.parse(plaintext) as ServiceAccountCredentials;
    } catch {
      throw new BadRequestException(
        'Stored FCM credentials could not be decrypted. Re-upload the service account JSON.',
      );
    }
  }

  /**
   * Works out who a campaign would reach.
   *
   * Shared by `send` and `previewAudience` on purpose: the number shown in the
   * UI before sending has to be produced by the same code that decides who is
   * actually sent to, or the preview becomes a plausible lie the moment either
   * side is edited.
   */
  /**
   * How many push tokens a send to these devices would actually reach.
   *
   * Exposed so a caller can tell "there is nobody to reach" apart from "the
   * send failed" *before* calling `send`, which raises a BadRequest for the
   * former. The journey runner needs that distinction: a person who never
   * granted notification permission, or who is already at the project's daily
   * cap, is the ordinary case and must not have their journey killed by it.
   *
   * Shares `resolveAudience` rather than counting separately, so this cannot
   * drift from the condition `send` actually rejects on — including the
   * frequency cap, which excludes devices from the count as well as the send.
   */
  async countReachableDevices(
    projectId: string,
    deviceIdentityIds: string[],
  ): Promise<number> {
    // Guarded rather than delegated: resolveAudience treats an empty device
    // list as "no device filter" and falls through to counting the entire
    // project, which would be the opposite of the answer asked for.
    if (deviceIdentityIds.length === 0) return 0;

    const { totalTokens } = await this.resolveAudience({
      projectId,
      deviceIdentityIds,
    });
    return totalTokens;
  }

  private async resolveAudience(input: {
    projectId: string;
    segmentId?: string;
    deviceIdentityIds?: string[];
  }): Promise<{
    targetType: 'project' | 'devices' | 'segment';
    targetDeviceIds: string[] | null;
    totalTokens: number;
  }> {
    // The cap excludes devices from delivery, so it has to exclude them from
    // the count too — otherwise the preview promises reach the send cannot
    // deliver.
    const config = await this.configRepository.findOne({
      where: { projectId: input.projectId },
    });
    const cap = config?.frequencyCapPerDay ?? null;

    if (input.segmentId) {
      const segment = await this.segmentsService.findOne(
        input.projectId,
        input.segmentId,
      );
      const personKeys = await this.collectSegmentMembers(segment);
      const targetDeviceIds =
        await this.segmentEvaluation.resolveDeviceIdentityIds(
          input.projectId,
          personKeys,
        );
      return {
        targetType: 'segment',
        targetDeviceIds,
        totalTokens:
          await this.pushTokensService.countTokensByDeviceIdentityIds(
            input.projectId,
            targetDeviceIds,
            cap,
          ),
      };
    }

    if (input.deviceIdentityIds && input.deviceIdentityIds.length > 0) {
      // Ids come from the request, so keep only this project's before they
      // are stored. The token readers also filter by project, but a stored
      // list naming foreign devices would still mislead anyone reading it. An
      // emptied list must refuse, never fall through to the project-wide
      // branch below.
      const targetDeviceIds = await this.identityService.idsInProject(
        input.projectId,
        [...new Set(input.deviceIdentityIds)],
      );
      if (targetDeviceIds.length === 0) {
        throw new BadRequestException('None of these devices belong to this project.');
      }
      return {
        targetType: 'devices',
        targetDeviceIds,
        totalTokens:
          await this.pushTokensService.countTokensByDeviceIdentityIds(
            input.projectId,
            targetDeviceIds,
            cap,
          ),
      };
    }

    return {
      targetType: 'project',
      targetDeviceIds: null,
      totalTokens: await this.pushTokensService.countActiveTokensByProject(
        input.projectId,
        cap,
      ),
    };
  }

  /** How many devices a campaign would reach, resolved but not sent. */
  async previewAudience(dto: PreviewAudienceDto): Promise<{
    targetType: 'project' | 'devices' | 'segment';
    totalTokens: number;
    deviceCount: number | null;
  }> {
    const { targetType, targetDeviceIds, totalTokens } =
      await this.resolveAudience(dto);
    return {
      targetType,
      totalTokens,
      // Devices and tokens differ: one person may have several installs, and a
      // device that has never registered for push has no token at all.
      deviceCount: targetDeviceIds ? targetDeviceIds.length : null,
    };
  }

  /**
   * Reports which Firebase account is wired up, not merely that one is.
   *
   * Only the two identifying fields are returned. A service account JSON also
   * carries the private key, which must never leave the server, so the object
   * is built field by field rather than spread.
   */
  /**
   * Updates the project's delivery guardrails.
   *
   * Clearing the cap also stops the server writing per-recipient send rows,
   * so a project that turns capping off stops paying for it immediately.
   */
  /**
   * Writes only the policy fields whose value changes, compared with the row under a
   * lock, and logs `channel.settings_changed` with their names in the same transaction.
   * A save that changes nothing writes and logs nothing.
   */
  async updateSettings(
    dto: UpdatePushSettingsDto,
    actorId: string,
    ctx: ActivityContext,
  ): Promise<{
    frequencyCapPerDay: number | null;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    maxSendsPerMinute: number | null;
  }> {
    return this.configRepository.manager.transaction(async (manager) => {
      const configs = manager.getRepository(PushConfigEntity);
      const config = await configs.findOne({
        where: { projectId: dto.projectId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!config) {
        throw new NotFoundException(
          'Push notifications not configured for this project. Call configure first.',
        );
      }
      // Both ends or neither: a half-configured window would silently do
      // nothing, which reads as the feature being broken.
      const start = dto.quietHoursStart ?? null;
      const end = dto.quietHoursEnd ?? null;
      if ((start === null) !== (end === null)) {
        throw new BadRequestException(
          'Quiet hours need both a start and an end, or neither.',
        );
      }
      const next = {
        frequencyCapPerDay: dto.frequencyCapPerDay ?? null,
        quietHoursStart: start,
        quietHoursEnd: end,
        maxSendsPerMinute: dto.maxSendsPerMinute ?? null,
      };
      const fields = changedFields(config, next);
      if (fields.length === 0) return next;
      await configs.update(
        { id: config.id },
        Object.fromEntries(fields.map((field) => [field, next[field]])) as Partial<PushConfigEntity>,
      );
      await this.activity.record(
        {
          projectId: dto.projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'channel.settings_changed',
          target: channelTarget('push'),
          details: { channel: 'push', fields },
        },
        ctx,
        manager,
      );
      return next;
    });
  }

  async getConfigStatus(projectId: string): Promise<{
    configured: boolean;
    isActive: boolean;
    firebaseProjectId: string | null;
    clientEmail: string | null;
    updatedAt: Date | null;
    frequencyCapPerDay: number | null;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    maxSendsPerMinute: number | null;
  }> {
    const config = await this.configRepository.findOne({
      where: { projectId },
    });

    if (!config) {
      return {
        configured: false,
        isActive: false,
        firebaseProjectId: null,
        clientEmail: null,
        updatedAt: null,
        frequencyCapPerDay: null,
        quietHoursStart: null,
        quietHoursEnd: null,
        maxSendsPerMinute: null,
      };
    }

    let firebaseProjectId: string | null = null;
    let clientEmail: string | null = null;
    try {
      const credentials = await this.decryptCredentials(projectId);
      firebaseProjectId = credentials.project_id ?? null;
      clientEmail = credentials.client_email ?? null;
    } catch {
      // Undecryptable credentials are still worth reporting as "configured" so
      // the dashboard can show that something is stored but unreadable, rather
      // than claiming nothing is set up.
      this.logger.warn(
        `Stored FCM credentials for project ${projectId} could not be read`,
      );
    }

    return {
      configured: true,
      isActive: config.isActive,
      firebaseProjectId,
      clientEmail,
      updatedAt: config.updatedAt,
      frequencyCapPerDay: config.frequencyCapPerDay ?? null,
      quietHoursStart: config.quietHoursStart ?? null,
      quietHoursEnd: config.quietHoursEnd ?? null,
      maxSendsPerMinute: config.maxSendsPerMinute ?? null,
    };
  }

  /**
   * Validates the request, records a queued campaign, and hands delivery to the
   * worker. Returns as soon as the job is enqueued — the previous implementation
   * fanned out to every token inside the request, which could not survive a
   * timeout, a deploy, or a crash.
   *
   * A dashboard request (`requester`) writes `campaign.sent` or `campaign.scheduled`
   * with the row; `null` is a send the platform makes itself (a journey step, one batch
   * of a cohort push), which writes nothing here.
   */
  async send(
    dto: SendPushNotificationDto,
    requester: ActivityRequester | null,
  ): Promise<PushNotificationLogEntity> {
    return this.createCampaign(
      dto,
      requester && {
        requester,
        entry: (saved) => campaignEntry(saved, heldOrSent(saved)),
      },
    );
  }

  private async createCampaign(
    dto: SendPushNotificationDto,
    logging: CampaignLogging | null,
  ): Promise<PushNotificationLogEntity> {
    const config = await this.configRepository.findOne({
      where: { projectId: dto.projectId, isActive: true },
    });

    if (!config) {
      throw new NotFoundException(
        'Push notifications not configured for this project. Call configure first.',
      );
    }

    const { targetType, targetDeviceIds, totalTokens } =
      await this.resolveAudience(dto);

    if (totalTokens === 0) {
      throw new BadRequestException(
        // Opted-out devices and those at the frequency cap are left out of
        // the count, so "none at all" covers them too.
        'No reachable push tokens for the target users (none registered, opted out of push, or at the frequency cap)',
      );
    }

    // A time in the past is treated as "now" rather than rejected: a clock
    // skew of a few seconds between browser and server should not turn a send
    // into an error.
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;

    // A local-time campaign is always held, even with no explicit time: the
    // sweep has to split it into per-timezone children before anything can be
    // sent, and sending it directly would deliver at one instant to everyone,
    // which is the opposite of what was asked for.
    // Optimising the send hour only means something on a known clock, so it
    // implies per-timezone delivery rather than conflicting with it.
    const sendTimeOptimised = dto.sendTimeOptimised === true;
    const deliverInRecipientTimezone =
      dto.deliverInRecipientTimezone === true || sendTimeOptimised;

    // An experiment is always held: it has to be split into arms before
    // anything can go out, and sending it directly would deliver one arm's
    // copy to the whole audience and record no variant at all.
    const isExperiment = !!dto.variants && dto.variants.length > 0;
    if (isExperiment) {
      const problem = validateVariants(
        dto.variants!,
        dto.controlPercentage ?? 0,
      );
      if (problem) throw new BadRequestException(problem);
    }

    // A recurring campaign is a template: it is never sent itself, it spawns
    // an occurrence each period, so it is always held.
    const isRecurring = !!dto.recurrence;
    if (isRecurring) {
      const problem = validateRecurrence(dto.recurrence!);
      if (problem) throw new BadRequestException(problem);
    }

    const isScheduled =
      deliverInRecipientTimezone ||
      isExperiment ||
      isRecurring ||
      (scheduledAt !== null && scheduledAt.getTime() > Date.now());

    if (dto.carousel) {
      const problem = validateCarousel(dto.carousel);
      if (problem) throw new BadRequestException(problem);
    }

    if (dto.timer) {
      // Checked against when this will actually go out, not now: a campaign
      // scheduled for next week with a countdown ending tomorrow would pass at
      // compose time and arrive already expired.
      const problem = validateTimer(dto.timer, scheduledAt ?? new Date());
      if (problem) throw new BadRequestException(problem);
    }

    const log = await saveCampaign(
      this.logRepository,
      this.activity,
      this.logRepository.create({
        projectId: dto.projectId,
        title: dto.title,
        body: dto.body,
        data: dto.data,
        imageUrl: dto.imageUrl ?? null,
        deepLinkUrl: dto.deepLinkUrl ?? null,
        silent: dto.silent ?? false,
        deliveryOptions: (dto.deliveryOptions ?? null) as never,
        actions: (dto.actions ?? null) as never,
        iosCategory: dto.iosCategory ?? null,
        carousel: (dto.carousel ?? null) as never,
        timer: (dto.timer ?? null) as never,
        targetType,
        targetDeviceIds,
        segmentId: dto.segmentId ?? null,
        totalTokens,
        processedTokens: 0,
        successCount: 0,
        failureCount: 0,
        // For a local-time campaign scheduledAt is when to *split* it, not
        // when to send; each child gets its own real send time.
        scheduledAt: isRecurring
          ? // The template's own scheduledAt is when the *first* occurrence
            // fires; the sweep advances it from there.
            (nextOccurrence(dto.recurrence!, scheduledAt ?? new Date()) ??
              new Date())
          : deliverInRecipientTimezone || isExperiment
            ? (scheduledAt ?? new Date())
            : isScheduled
              ? scheduledAt
              : null,
        recurrence: isRecurring ? dto.recurrence! : null,
        translations: dto.translations ?? null,
        variants: isExperiment ? dto.variants! : null,
        controlPercentage: isExperiment ? (dto.controlPercentage ?? 0) : null,
        deliverInRecipientTimezone,
        sendTimeOptimised,
        localSendTime: deliverInRecipientTimezone
          ? (dto.localSendTime ?? '09:00')
          : null,
        status: isScheduled ? 'scheduled' : 'queued',
      } as Partial<PushNotificationLogEntity>) as PushNotificationLogEntity,
      logging,
    );

    await this.recordTemplateUse(dto.projectId, dto.templateId);

    // A scheduled campaign gets no job now. PushCampaignScheduleScheduler
    // claims it when its time comes; enqueuing here with a BullMQ delay would
    // put the schedule in Redis, where it could not be listed or cancelled
    // from the dashboard and would not survive losing the queue.
    if (isScheduled) {
      // Read from the saved row, not the local variable: an experiment or a
      // local-time campaign is given a default send time when it is written,
      // so the local one is still null here.
      const when = log.scheduledAt?.toISOString() ?? 'immediately';
      this.logger.log(
        isRecurring
          ? `Recurring campaign ${log.id} scheduled, first occurrence ${when} (${totalTokens} token(s))`
          : isExperiment
            ? `Experiment ${log.id} will be split into ${dto.variants!.length} arm(s) at ${when} (${totalTokens} token(s))`
            : deliverInRecipientTimezone
              ? `Campaign ${log.id} will be split by recipient timezone for ${log.localSendTime} local (${totalTokens} token(s))`
              : `Scheduled push campaign ${log.id} for ${when} (${totalTokens} token(s))`,
      );
      return log;
    }

    // jobId is the log id, so a duplicate enqueue for the same campaign is
    // deduplicated by BullMQ rather than double-sending.
    await this.pushQueue.add(
      JOB_DISPATCH_CAMPAIGN,
      { logId: log.id, projectId: dto.projectId },
      { jobId: log.id },
    );

    this.logger.log(
      `Queued push campaign ${log.id} for ${totalTokens} token(s)`,
    );

    return log;
  }

  /**
   * Notes that a campaign came from a template.
   *
   * Best-effort: a usage counter is never worth failing a send over, and the
   * campaign is already created by the time this runs.
   */
  private async recordTemplateUse(
    projectId: string,
    templateId: string | undefined,
  ): Promise<void> {
    if (!templateId) return;
    try {
      await this.pushTemplates.recordUse(projectId, templateId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(
        // Database errors repeat the values they refused.
        `Could not record use of template ${logValue(templateId)}: ${logValue(detail)}`,
      );
    }
  }

  /**
   * Cancels a campaign that has not been dispatched yet.
   *
   * Only `scheduled` can be cancelled. Once promoted, a campaign has a queue
   * job and may already be part-way through a token page; stopping it there
   * would need cooperative cancellation in the worker, which is a different
   * feature from "I picked the wrong time".
   */
  async cancelScheduled(
    projectId: string,
    campaignId: string,
    requester: ActivityRequester,
  ): Promise<PushNotificationLogEntity> {
    const log = await this.logRepository.findOne({
      where: { id: campaignId, projectId },
    });

    if (!log) {
      throw new NotFoundException('Campaign not found for this project');
    }

    if (log.status !== 'scheduled') {
      throw new BadRequestException(
        `Only a scheduled campaign can be cancelled; this one is ${log.status}.`,
      );
    }

    log.status = 'cancelled';
    log.completedAt = new Date();
    // The entry commits with the cancel; one that found nothing to cancel threw above.
    return this.logRepository.manager.transaction(async (manager) => {
      const saved = await manager.getRepository(PushNotificationLogEntity).save(log);
      await recordBy(this.activity, requester, campaignEntry(saved, 'campaign.cancelled'), manager);
      return saved;
    });
  }

  /**
   * Every device behind a segment's members, with the same size limit a push
   * send applies. Public so the email channel targets a segment through
   * exactly the code push does.
   */
  async segmentDeviceIdentityIds(
    projectId: string,
    segmentId: string,
  ): Promise<string[]> {
    const segment = await this.segmentsService.findOne(projectId, segmentId);
    const personKeys = await this.collectSegmentMembers(segment);
    return this.segmentEvaluation.resolveDeviceIdentityIds(projectId, personKeys);
  }

  /** Walks the whole segment, refusing an audience too large to store inline. */
  private async collectSegmentMembers(segment: SegmentEntity): Promise<string[]> {
    const all: string[] = [];
    let cursor: string | null = null;

    for (;;) {
      const page = await this.segmentEvaluation.enumerate(segment, cursor, 1000);
      if (page.length === 0) break;
      all.push(...page);
      if (all.length > SEGMENT_SEND_MAX_PEOPLE) {
        throw new BadRequestException(
          `Segment has more than ${SEGMENT_SEND_MAX_PEOPLE} members; ` +
            `narrow it or split the campaign`,
        );
      }
      cursor = page[page.length - 1];
      if (page.length < 1000) break;
    }

    return all;
  }

  /**
   * One person's devices, by their distinct id. Logged as `push.sent_to_person` naming
   * the person by internal id only (the most recently seen of their device rows): never
   * the distinct id the request named, an address or a token, which are end-user data.
   */
  async sendToUser(dto: SendToUserDto, requester: ActivityRequester): Promise<PushNotificationLogEntity> {
    const identities = await this.identityService.findByDistinctId(
      dto.distinctId,
      dto.projectId,
    );

    if (identities.length === 0) {
      throw new NotFoundException(
        `No devices found for distinctId: ${dto.distinctId}`,
      );
    }

    const person = [...identities].sort(
      (a, b) =>
        (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0) || a.id.localeCompare(b.id),
    )[0];

    return this.createCampaign(
      {
        projectId: dto.projectId,
        title: dto.title,
        body: dto.body,
        data: dto.data,
        imageUrl: dto.imageUrl,
        deviceIdentityIds: identities.map((i) => i.id),
      },
      {
        requester,
        entry: (saved) => ({
          projectId: saved.projectId,
          action: 'push.sent_to_person',
          target: { type: 'person', id: person.id, label: null },
        }),
      },
    );
  }

  /**
   * One campaign, with its engagement.
   *
   * The detail page previously found a campaign by scanning the paginated
   * list, so anything outside the most recent 50 rendered as "not found"
   * despite existing — and the page held the whole list, inheriting its
   * poll-while-any-campaign-is-active refetch.
   */
  async getCampaign(
    projectId: string,
    campaignId: string,
  ): Promise<PushNotificationLogEntity & { engagement: CampaignEngagement }> {
    const log = await this.logRepository.findOne({
      where: { id: campaignId, projectId },
    });
    if (!log) {
      throw new NotFoundException('Campaign not found for this project');
    }
    const engagement = await this.pushAnalytics.getEngagementFor([log.id]);
    return {
      ...log,
      engagement: engagement.get(log.id) ?? {
        campaignId: log.id,
        delivered: 0,
        impressions: 0,
        clicks: 0,
        dismissed: 0,
        bounced: 0,
        complained: 0,
        clickThroughRate: null,
      },
    };
  }

  async getLogs(
    projectId: string,
    limit = 50,
    offset = 0,
    /** Only campaigns on this channel. Omitted means every channel. */
    channel?: MessageChannel,
  ): Promise<{
    data: Array<PushNotificationLogEntity & { engagement: CampaignEngagement }>;
    total: number;
  }> {
    const [data, total] = await this.logRepository.findAndCount({
      where: channel ? { projectId, channel } : { projectId },
      order: { sentAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    // One grouped aggregate for the whole page rather than a count per row:
    // this list polls every three seconds while a campaign is in flight.
    const engagement = await this.pushAnalytics.getEngagementFor(
      data.map((log) => log.id),
    );

    return {
      data: data.map((log) => ({
        ...log,
        engagement: engagement.get(log.id) ?? {
          campaignId: log.id,
          delivered: 0,
          impressions: 0,
          clicks: 0,
          dismissed: 0,
          bounced: 0,
          complained: 0,
          clickThroughRate: null,
        },
      })),
      total,
    };
  }
}
